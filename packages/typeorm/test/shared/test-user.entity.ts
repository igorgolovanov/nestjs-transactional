import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Minimal entity reused by both the unit and integration adapter specs.
 * Table name is snake_case so Postgres accepts the identifier without
 * any quoting.
 */
@Entity({ name: 'test_user' })
export class TestUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}
