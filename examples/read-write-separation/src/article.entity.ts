import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'articles' })
export class ArticleRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'int', default: 0 })
  viewCount!: number;
}
